# Vocoder 合成长音频用时异常巨大 — 优化 TODO

## 问题 1：每次 chunk 推理有独立的 GPU 调度开销

**位置：** `_runVocoderChunked()` (L1359-1420)

每个 chunk 调用 `session.run()` 串行等待 GPU，涉及 JS→Native 数据拷贝、GPU kernel 调度、GPU 执行等待、Native→JS 数据拷贝、microtask 调度。对短 chunk（2.56 秒），调度开销可能占总时间 30-50%。

- [ ] 增大 `VOCODER_CHUNK_FRAMES`（128 → 512 或 1024），减少调度次数 50-75%
- [ ] 考虑多 chunk 并行推理（Promise.all 批量提交），吞吐提升 2-3x（需注意 GPU 显存）

---

## 问题 2：每个 chunk 都创建新的 Tensor 对象

**位置：** `_runVocoderChunked()` L1381-1388

每个 chunk 分配新的 `Float32Array`、`ort.Tensor`、如果是 FP16 还有 `Float16Array`。14 个 chunk = 14 次分配 + 14 次 Tensor 创建 + 14 次类型转换。

- [ ] 预分配复用 Tensor 缓冲区，减少 GC 压力和分配开销

---

## 问题 3：FP16 模型的双重转换开销

**位置：** `createFloatTensor()` (L380-385)、`outputToFloat32()` (L388-393)

当 `isFP16 === true` 时，每个 chunk 输入一次 f32→f16、输出一次 f16→f32，都是逐元素 for 循环转换。每 chunk 约 78K 次 float 转换（128×128 mel + 61440 waveform）。

- [ ] FP16 路径用 `Uint16Array` 直接操作，避免 `Float16Array` 逐元素循环
- [ ] 考虑直接在 Float32 空间计算，仅在创建 Tensor 时做一次批量转换

---

## 问题 4：`float32ToF16Buffer` 实现低效

**位置：** L362-368

逐元素赋值 `f16[i] = f32Data[i]`，V8 对 `Float16Array` 的逐元素赋值没有 SIMD 优化路径（Float16Array 是 v24 新增类型），比 `TypedArray.set()` 慢很多。

- [ ] 替换为批量操作或 wasm 实现的 f32→f16 转换
- [ ] 探索 V8 是否支持 `Float32Array` → `Float16Array` 的 `set()` 或 `Float16Array.from()` 优化路径

---

## 问题 5：长音频分段 + vocoder chunked 双重开销

**位置：** `synthesize()` → `_synthesizeSegment()` → `_runVocoderChunked()`

长音频（>30s）触发分段推理，每段内部又走 chunked vocoder，分段间串行、每段 vocoder 也串行 chunked，开销叠加。

- [ ] 分段模式 vocoder 流水线化：段 N diffusion 完成即启动 vocoder，与段 N+1 diffusion 并行，端到端减少 30-40%
- [ ] 评估是否可以跨段合并 vocoder 推理

---

## 问题 6：无 GC 释放中间缓冲区

**位置：** `_runVocoderChunked()` while 循环内

`chunkMel`、`melTensor`、`waveform` 等在循环内反复分配但不释放。Node.js GC 在内存压力不大时不会主动回收，但积累后可能触发 full GC 造成延迟尖峰。

- [ ] 在 chunk 循环内主动置空不再需要的变量，辅助 GC
- [ ] 评估是否需要在循环间隔调用 `global.gc()`（需 `--expose-gc` 启动参数）

---

## 优化优先级

| 优先级 | 优化项 | 预估收益 | 改动难度 |
|---|---|---|---|
| P0 | 增大 chunk 大小（128→512/1024） | 减少调度次数 50-75% | 低（改常量） |
| P1 | 预分配复用 Tensor 缓冲区 | 减少 GC 压力和分配开销 | 中 |
| P1 | FP16 转换优化 | 每chunk 节省 ~5ms | 中 |
| P2 | 多 chunk 并行推理 | 吞吐提升 2-3x | 高（需注意 GPU 显存） |
| P2 | 分段 vocoder 流水线化 | 端到端减少 30-40% | 高 |
| P3 | GC 优化 | 减少延迟尖峰 | 低 |
