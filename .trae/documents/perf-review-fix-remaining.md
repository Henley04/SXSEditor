# 性能审查剩余问题修复计划

## 概述

上一轮已修复 14 项（WebNN 张量释放、DML cond/mask 提升、durationStats 懒加载、RMVPE/RosVot 张量释放 + f0 LUT、canvas clientHeight 缓存、WAV memcpy、bessel0 提升、vocab/dict size 缓存、VOC_PARALLEL 移除、WebNN CFG 2-pass、Float16Array 批量化、VRAM chunking 改进）。

本计划修复**所有剩余可行且有收益**的性能问题，按 4 条并行流执行。每条流操作不同文件集，无冲突。

---

## 当前状态（已验证）

git 最新提交 `98948a9`（SiFiGAN WebNN 支持）+ `7612c60`（中优先级 perf 修复）。测试 `npm test` 全部通过（1038 项）。

---

## Stream A：前端渲染（renderer 进程）

### A1. 波形离屏 canvas 缓存 + 尺寸守卫
**文件**: `src/audioPreprocess/canvasRenderer.js`
**问题**: 每帧 rAF 重新设置 canvas 尺寸 + ctx.scale + O(width×samplesPerPixel) 扫描，无离屏缓存
**修复**:
- 新建模块级 `_waveformCacheCanvas`（OffscreenCanvas 或 document.createElement('canvas')）
- 当 `audioData` / `wavDuration` / `width` / `zoomX` / `scrollX` 变化时才重绘离屏波形
- 每帧只 `ctx.drawImage(_waveformCacheCanvas, 0, 0)` + 绘制播放头
- `drawWaveformWithPlayhead` 顶部加尺寸守卫：`if (canvas.width === expectedW && canvas.height === expectedH) skip resize`
- 预计算 min/max peak table（按像素列索引），避免每帧重新扫描采样数据

### A2. pianoRoll 静态层缓存（播放期间）
**文件**: `src/audioPreprocess/pianoRoll.js`
**问题**: `_tickPlayback` 每帧调 `this.render()`（全量重绘背景/网格/音符/琴键/F0）+ `drawWaveformWithPlayhead`（全量波形）
**修复**:
- 仿照 `src/editor/pianoRoll.js` 的 `_staticCache` / `_staticCacheDirty` 模式
- 播放期间：静态层（背景/网格/音符/琴键）drawImage 缓存，仅重绘播放头
- 编辑操作（拖拽音符、缩放、滚动）时设 `_staticCacheDirty = true`
- `_tickPlayback` 中 `this.render()` 改为仅重绘动态层

### A3. editor/pianoRoll.js 滚轮缩放 rAF 批处理 + 静态缓存扩展
**文件**: `src/editor/pianoRoll.js`
**问题**: `_onWheel` 每事件同步调 `this.render()`；静态缓存仅播放时生效
**修复**:
- `_onWheel` 改用 rAF 批处理（`_renderRaf` 模式，同 fragmentEditor）
- 静态缓存扩展到非播放场景：滚动/缩放不修改音符，可复用缓存（仅滚动偏移不同时重绘）
- 编辑操作（增删音符、拖拽）才设 `_staticCacheDirty = true`

### A4. timelineRenderer canvas 尺寸守卫
**文件**: `src/renderer/timelineRenderer.js`
**问题**: 每次渲染无条件设置 `fragmentCanvas.width/height` + `fragmentPlayheadCanvas.width/height`，即使尺寸不变
**修复**:
- 封装 `_ensureCanvasSize(canvas, w, h, dpr)` 函数，尺寸相等时提前返回
- 应用于 `fragmentCanvas` 和 `fragmentPlayheadCanvas`

### A5. fragmentEditor 静态层缓存
**文件**: `src/fragmentEditor/canvasRenderer.js`
**问题**: `_doRenderImpl` 每帧全量重绘（背景/网格/音符/参数区/琴键），无静态层缓存
**修复**:
- 新建 `_staticCacheCanvas` + `_staticCacheDirty`
- 静态元素（背景/网格/琴键）绘到离屏 canvas，dirty 时才重绘
- 动态元素（播放头/选框/拖拽预览）每帧绘到主 canvas
- `render()` 调用时：`drawImage(_staticCacheCanvas)` + 绘制动态层

### A6. fragmentEditor 独占播放 render() 缺失修复（BUG）
**文件**: `src/fragmentEditor/audioPlayback.js`
**问题**: `updateFragmentExclusivePlayhead` 循环体仅 `setFragmentCurrentTime(elapsed)`，不调 `render()`，播放头视觉冻结
**修复**: 在 `setFragmentExclusiveRaf(requestAnimationFrame(update))` 前加 `render()` 调用

### A7. visibilitychange 暂停 rAF
**文件**: `src/renderer/audioPlayback.js`, `src/fragmentEditor/audioPlayback.js`, `src/audioPreprocess/pianoRoll.js`
**问题**: 多个播放头 rAF 循环无 visibilitychange 暂停，窗口隐藏时仍跑
**修复**:
- 每个模块加 `document.addEventListener('visibilitychange', ...)` 监听器
- `document.hidden` 时取消 rAF；`visible` 时若仍在播放则恢复 rAF
- 导出 `cleanupVisibilityHandler()` 供模块销毁时调用

### A8. 移除 Array.from(Float32Array)
**文件**: `src/renderer/fragmentOperations.js` (line 117)
**问题**: `Array.from(channelData)` 将 Float32Array 转为装箱 JS Array，~8M 元素 → ~64MB 瞬时内存 + 数百 ms 主线程阻塞
**修复**: 直接传 `channelData`（Float32Array）。验证下游 `extractMidiRosvot` / `extractF0BasicPitch` IPC 是否接受 Float32Array（Electron 结构化克隆原生支持 TypedArray）

### A9. backdrop-filter: blur 替换
**文件**: `src/components.css` (L139,182), `src/fragmentEditor.css` (L22,633), `src/audioPreprocess.css` (L193), `src/settings.css` (L624), `src/renderer/uiControls.js` (L30,360)
**问题**: 全屏 overlay 上 `backdrop-filter: blur(2px)` 强制合成器对底层内容做高斯模糊
**修复**: 替换为更不透明的纯色背景（`rgba(0,0,0,0.55)` → `rgba(0,0,0,0.65)`），移除 `backdrop-filter`。视觉差异极小（2px 模糊几乎不可见）

### A10. projectManager base64 异步化
**文件**: `src/renderer/projectManager.js` (L86-91, L240-244)
**问题**: `serializeProject` 同步 `String.fromCharCode` 分块 + `btoa()`；`applySingerDataToSinger` 同步 `atob()` + 逐字节拷贝
**修复**:
- **编码**：用 `Blob` + `FileReader.readAsDataURL` 异步编码（不阻塞主线程）
- **解码**：用 `fetch('data:audio/wav;base64,...')` → `arrayBuffer()` 异步解码
- `serializeProject` 改为 `async`，调用方加 `await`

---

## Stream B：CPU 算法优化

### B1. 稀疏 mel 滤波器组（CSR）
**文件**: `src/inference/pipeline/postprocessing.js` (L513-523)
**问题**: 密集标量三重循环 `O(frames × bands × bins)`，每个 mel 三角形约 3 个非零 bin
**修复**:
- 构建 mel filterbank 时预计算 CSR 格式：`csrValues[]`, `csrColIdx[]`, `csrRowPtr[]`
- 内层循环改为遍历非零元素（约 3 个/bin），减少 ~300 倍迭代
- 缓存 CSR 结构（同现有 `_cachedMelFilterbank` 模式）

### B2. ISTFT 暂存缓冲区复用
**文件**: `src/inference/pipeline/postprocessing.js` (L386-387)
**问题**: 每帧 `new Float32Array(nFft) × 2`
**修复**:
- 提升到循环外：`const ifftReal = new Float32Array(nFft); const ifftImag = new Float32Array(nFft);`
- 每帧 `ifftReal.fill(0); ifftImag.fill(0);`（比 new 快，复用内存）

### B3. parseWavBuffer 类型化数组视图
**文件**: `src/inference/pipeline/postprocessing.js` (L119-140)
**问题**: 每采样 `view.getFloat32(byteOffset, true)`
**修复**:
- 32-bit float 路径：`new Float32Array(buf.buffer, dataOffset, totalSamples)` 直接视图
- 16-bit int 路径：`new Int16Array(buf.buffer, dataOffset, totalSamples)` + 批量转换
- 仅对非标准格式回退到 DataView

### B4. pipeline CFG 3→2 pass 合并
**文件**: `src/inference/pipeline/diffusion.js` (L192-241)
**问题**: 3 个独立循环（CFG pred / 方差 / rescale+更新），WebNN 路径已合并为 2
**修复**:
- 合并 pass 2（方差）和 pass 3（rescale+更新）为单次遍历
- 参照 `src/inference/webnn/diffusion.js` L195-210 的合并模式
- 保留 yield 点（`totalFrames > 256` 时 setImmediate 分块）

### B5. outputToNotesPoly O(N²)→O(N) 
**文件**: `src/inference/basicPitch.js` (L240-296)
**问题**: 每检测一个音符全扫描 `remainingEnergy` 2D 矩阵找 globalMax
**修复**:
- 预计算每列（freqBin）的运行最大值 + 索引
- 用优先队列（或扁平数组 + 减量更新）维护全局最大
- 提取一个音符后，仅更新受影响列的运行最大值
- 复杂度从 O(N² × F) 降到 O(N × F)

### B6. basicPitch arraySync→dataSync
**文件**: `src/inference/basicPitch.js` (L546-548, L554-556)
**问题**: `arraySync()` 返回嵌套 JS 数组（装箱），`dataSync()` 返回扁平 TypedArray
**修复**:
- 改用 `dataSync()` 获取扁平 TypedArray
- 更新 `outputToNotesPoly` 及下游消费者：用 `frames[r * cols + c]` 替代 `frames[r][c]`
- 保留输出语义不变

### B7. applyEnvelopesToAudio 三角函数预计算
**文件**: `src/audio/wavEncoder.js` (L89-91)
**问题**: 每采样 `Math.cos` / `Math.sin`（2 分钟立体声 → 576 万次调用）
**修复**:
- pan 在同一 envelope 段内是常数 → 预计算 `leftGain` / `rightGain` 到段级变量
- 仅在 envelope 段边界重新计算
- 验证 pan 是否逐采样变化（若逐采样变化，改用查找表 LUT）

### B8. audioSegmentation element-wise→TypedArray.set
**文件**: `src/inference/webnn/audioSegmentation.js` (L68-73)
**问题**: 嵌套 for 循环复制连续 mel 数据
**修复**: `chunkMel.set(xtData.subarray(offset * MEL_DIM, (offset + chunkFrames) * MEL_DIM))`

### B9. webnn/diffusion element-wise→TypedArray.set
**文件**: `src/inference/webnn/diffusion.js` (L350-354)
**问题**: ptMelData 逐元素复制
**修复**: 用 `TypedArray.set(subarray(...))` 替代（验证数据连续性后）

---

## Stream C：主进程 IPC + 内存

### C1. audioOutputManager worker.send transferList
**文件**: `src/audio/audioOutputManager.js` (L151, L215-218)
**问题**: `worker.send({ id, type, ...data })` 无 transferList，Float32Array 被结构化克隆（复制 ~57MB）
**修复**:
- `_sendCommand` 增加可选 `transferList` 参数
- `start()` 调用时传 `[audioArray.buffer]`
- 验证：`audioArray` 在 `start()` 后不被复用（已确认不存储）→ 安全 transfer
- 注意：若 `audioData` 来自外部引用，先 `audioArray = audioData.slice()` 再 transfer

### C2. singerIpc saveSingerFile 异步化
**文件**: `src/main/singerIpc.js` (L122-144)
**问题**: 同步 `Buffer.toString('base64')` + 同步 `JSON.stringify` 阻塞主线程
**修复**:
- 用 `worker_thread` 执行 base64 编码 + JSON 序列化
- 或分块 `setImmediate` 让出（base64 本身是 native 快操作，主要瓶颈是 JSON.stringify 巨大字符串）
- 方案：`const worker = new Worker(code, { eval: true })` 内联 worker，传入 Buffer，返回字符串

### C3. webnn:readModelFile 零拷贝传输
**文件**: `src/main/webnnIpc.js` (L140-151)
**问题**: `ipcMain.handle` 返回 ArrayBuffer 被结构化克隆（复制 846MB diffStep 模型）
**修复**:
- 改用 `ipcMain.on('webnn:readModelFile', async (event, filePath) => { ... event.sender.send('webnn:readModelFile:reply', { data: ab }, [ab]); })`
- 渲染进程改为 `ipcRenderer.send` + `ipcRenderer.once('webnn:readModelFile:reply', ...)` 包装为 Promise
- 需同步更新渲染进程调用方（搜索 `webnn:readModelFile` 的 invoke 调用）

### C4. sessionManager IPC 路径优化
**文件**: `src/inference/webnn/sessionManager.js`
**问题**:
- L221: 标量 `float32ToFloat16` 逐元素转换（应批量）
- L262: int64 输出 `Array.from(tensor.data, v => v.toString())` 慢
- L10: sessions Map 无界增长
- L118-126: timeout Promise 泄漏（setTimeout 回调在 resolve 后仍触发）

**修复**:
- L221: 改用 `batchFloat32ToFloat16(data)`（已存在于 `webnn/utils.js`）
- L262: 改用 `new BigInt64Array(tensor.data)` 直接视图 + `slice()`（若已是 BigInt64Array）
- sessions Map: 加 LRU 驱逐（上限 8 个 session，超出时 unload 最久未用的）
- timeout: 用 `AbortController` 或在 resolve 后 `clearTimeout`

### C5. RMVPE F0 提取移至 worker_thread
**文件**: `src/inference/rmvpePitchDetector.js`, `src/main/pitchMidiIpc.js`, 新建 `src/inference/pitchWorker.js`
**问题**: 同步 resample + ONNX 推理 + argmax 阻塞主线程数百毫秒（影响所有窗口 IPC）
**修复**:
- 新建 `src/inference/pitchWorker.js`（Node.js worker_thread）
- worker 内加载 RMVPE ONNX 模型 + 执行 resample + 推理 + argmax
- `pitchMidiIpc.js` 的 `extractF0:onnx` handler 改为转发到 worker
- worker 通过 `parentPort.postMessage(result, [transferList])` 返回 F0 数据
- 保留同步 fallback（worker 初始化失败时）
- 注意：DML EP 在 worker_thread 中可用（native addon 可加载）

### C6. svs:synthesize transferList — 不修
**原因**: LRU 缓存持有 Float32Array 引用，transfer 会 detach 缓存 buffer。复制后 transfer = 1 次拷贝 = 与结构化克隆等价，净收益为零。

---

## Stream D：GPU / NPU

### D1. NPU 性能门控
**文件**: `src/inference/webnn/npuDetection.js`
**问题**: NPU 检测仅检查可用性，不检查性能。慢 NPU 也能通过并承载完整 pipeline
**修复**:
- `detectNPU()` 中加载一个小型测试模型（或用现有模型做 dummy 推理）
- 测量推理延迟，若 > CPU 延迟的 1.5× 则标记 NPU 不可用
- 缓存结果（含延迟数据），避免重复测试
- 结果中增加 `npuInferenceMs` 字段供日志/诊断

### D2. classifyDevice 去重
**文件**: 新建 `src/utils/deviceClassifier.js`；修改 `src/utils/gpuWorker.js`, `src/inference/pipeline/modelLoader.js`, `src/main/gpuInfo.js`
**问题**: `classifyDevice` 在 3 个文件中重复，存在偏离风险
**修复**:
- 抽取到 `src/utils/deviceClassifier.js` 导出 `classifyDevice(name, vramBytes, dmlDiscreteFlag)`
- 三个文件改为 `require('../utils/deviceClassifier')`
- 逻辑保持一致（取现有实现合并）

### D3. NPU 故障重试（非永久缓存）
**文件**: `src/main/webnnIpc.js`
**问题**: `markNPUUnavailable` 永久缓存故障，瞬时驱动/电源故障后不重试
**修复**:
- 故障缓存加 TTL（如 5 分钟），过期后允许重新检测
- 或在 `swapLanguageModels` / 新合成会话时清除故障缓存
- 保留首次故障后的即时缓存（避免同一合成会话内反复失败）

### D4. NPU 静态形状截断用户警告
**文件**: `src/inference/webnn/index.js` (L62-73)
**问题**: 超过 `NPU_STATIC_SEQ_LEN=2048` 的音频被静默截断
**修复**:
- 截断时通过回调通知调用方（或设 `result.warnings` 数组）
- 调用方（`pipeline/index.js`）将警告转发到 UI
- 用户可见提示："NPU 静态形状限制：音频超过 2048 帧已被截断，建议使用 GPU 或分段合成"

### D5. 模型预热
**文件**: `src/inference/pipeline/modelLoader.js`, `src/inference/webnn/sessionManager.js`
**问题**: 无显式预热，首次合成即预热（用户感知卡顿）
**修复**:
- DML 路径：模型加载验证运行（已有 dummy run）改为完整 warmup（所有模型各跑一次 dummy 推理）
- WebNN 路径：`loadModel` 成功后立即跑一次 dummy 推理
- 预热在后台异步执行，不阻塞 UI
- 标记 `_warmedUp = true`，首次合成时跳过冷启动路径

### D6. IoBinding 可行性 — 不修（研究确认不可行）
**原因**: ONNX Runtime Node.js 绑定（onnxruntime-node）未暴露 `IoBinding` API。`session.run()` 不支持预分配 GPU 缓冲区。`enableMemPattern: false` 是 DML EP 的硬性要求。gpuDrain sleep 是当前唯一可行的 GPU 栅栏。需等待 ORT 上游添加 IoBinding 支持后方可实施。

---

## 不修复清单（附原因）

| 问题 | 原因 |
|------|------|
| gpuDrain → IoBinding | ORT Node.js 无 IoBinding API（D6 已确认） |
| svs:synthesize transferList | LRU 缓存引用，净收益为零（C6） |
| en_g2p_dict 永久常驻 | 设计如此，每次合成都需要 |
| _recreateHeavySessionsAfterSynthesis | gpuDrain 的衍生缓解，无法单独移除 |
| 多片段串行 while 循环 | DML 约束（并发 session.run 触发 887A） |
| Vocoder 块强制串行 | 同上 DML 约束 |
| WebNN/DML EP 策略分歧 | 架构性差异，不同后端需不同配置 |
| INT8 无精度回退 | 需音频质量评估，非纯性能问题 |
| NPU "INT8" 用词不当 | 命名问题，无性能影响 |
| Vocoder 硬编码 DML | NPU vocoder 优化是死代码，移除有风险 |
| WebNN batch=4 更多并行 | 并发风险触发 887A |

---

## 执行顺序

1. **git 备份**（不单独开分支）：`git add -A && git commit -m "backup: pre-perf-review-remaining-fixes"`
2. **4 条流并行执行**（4 个 subagent）：
   - Stream A（前端渲染）
   - Stream B（CPU 算法）
   - Stream C（主进程 IPC + 内存）
   - Stream D（GPU/NPU）
3. **每条流完成后**：在该流内运行 `npm test` 验证无回归
4. **全部完成后**：运行完整 `npm test`（1038 项）
5. **git 备份**：`git add -A && git commit -m "perf: fix all remaining perf review issues"`
6. **推送到远程**：`git push origin main`（用 `-c http.proxy= -c https.proxy=` 绕过代理）

## 验证步骤

- `npm test` 全部通过（1038 项 + 新增测试）
- `npm run lint` 无新增错误
- 手动验证（可选）：
  - 播放期间波形/钢琴卷帘不闪烁
  - F0 提取时 UI 不冻结
  - 模型切换后首次合成不卡顿（预热生效）
